'use strict';

/**
 * Contract: `accept <n>` and bare `accept` resolve server-side against the
 * poster's own ordered candidate list — no planId, no UUID, no identity
 * argument.
 *
 * Plan: a-seat-says-submit-and-a-lead-says-accept-n.md
 *
 * Asserts:
 *  - `task/complete` with `{ordinal: n}` accepts the nth subtask of the
 *    feature the poster holds — asserted against a feature whose third
 *    subtask is NOT the most recently touched, so "latest wins" fails;
 *  - bare `accept` resolves the single incomplete candidate and 400s —
 *    naming every candidate with its ordinal — on zero or many;
 *  - an out-of-range ordinal 400s naming the range and writes nothing;
 *  - ordinals are STABLE across an accept (`accept 1` then `accept 3` still
 *    hits the third subtask — accepted subtasks stay in the list);
 *  - `planId` + `ordinal` together is a 400, not a planId-with-hint;
 *  - a poster associated with two open features gets a named 400, never a
 *    quiet pick;
 *  - NON-FEATURE posters: a planning seat's bare accept resolves its own
 *    held card (its team's other seats are NOT candidates — it heads no
 *    team); a seat holding nothing 400s with the named reason; a headed
 *    batch lead's `accept <n>` indexes the roster's outstanding cards in
 *    ownerSince order;
 *  - `round/register` accepts ordinals (`rounds: [[1,2],[3]]`) with NO
 *    featureId — derived from the poster's held feature card — and stores
 *    planIds; a bad ordinal 400s naming the entry and the valid range.
 */

const assert = require('assert');
const path = require('path');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { LocalApiServer } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

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

const WS = '/tmp/accept-ordinal-resolution-ws';
const LEAD = 'Coding';
const ROSTER = [LEAD, 'Coding-coder-1', 'Coding-coder-2'];

/** A board row shaped the way `getBoard` returns them. */
function card(planId, extra = {}) {
    return {
        planId,
        sessionId: planId,
        topic: `topic-${planId}`,
        kanbanColumn: 'CODER CODED',
        featureId: '',
        ownerSeat: '',
        ownerSince: null,
        columnOrder: null,
        completedAt: null,
        isFeature: false,
        workspaceId: 'ws1',
        ...extra,
    };
}

/**
 * LocalApiServer with an in-memory store covering the resolve + complete +
 * register paths. `plans` preserves insertion order — the fake
 * `getSubtasksByFeatureId` returns subtasks in that order, which stands in
 * for the real store's `ORDER BY rowid`.
 */
function makeServer(opts = {}) {
    const plans = new Map();
    const rounds = new Map();
    const inserted = [];
    const dispatched = [];
    const events = [];
    const clears = [];

    const fakeDb = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => Array.from(plans.values()),
        getPlanByPlanId: async (planId) => plans.get(planId) || null,
        getSubtasksByFeatureId: async (featureId) => {
            const subs = [];
            for (const p of plans.values()) {
                if (p.featureId === featureId && !p.isFeature) subs.push(p);
            }
            return subs;
        },
        setCompletedAt: async (planId, timestamp) => {
            const p = plans.get(planId);
            if (!p) return false;
            p.completedAt = timestamp;
            return true;
        },
        appendPlanEventByPlanId: async (planId, event) => {
            events.push({ planId, ...event });
            return true;
        },
        getCodingRoundsByTeam: async (teamId) => Array.from(rounds.values())
            .filter(r => r.teamId === teamId).sort((a, b) => a.ordinal - b.ordinal),
        getCodingRoundsByFeature: async (featureId) => Array.from(rounds.values())
            .filter(r => r.featureId === featureId).sort((a, b) => a.ordinal - b.ordinal),
        getCodingRoundsByWorkspace: async () => Array.from(rounds.values()),
        deleteCodingRoundsByFeatureInStates: async (featureId, states) => {
            for (const [id, r] of Array.from(rounds.entries())) {
                if (r.featureId === featureId && states.includes(r.state)) rounds.delete(id);
            }
            return 1;
        },
        insertCodingRound: async (params) => {
            inserted.push(params);
            const entries = KanbanDatabase.prototype._parseSubtaskSeatEntries
                .call(null, JSON.stringify(params.subtasks));
            rounds.set(params.roundId, {
                roundId: params.roundId,
                featureId: params.featureId,
                teamId: params.teamId,
                workspaceId: params.workspaceId,
                ordinal: params.ordinal,
                totalRegistered: params.totalRegistered,
                state: 'registered',
                subtaskSeats: entries,
                subtaskPlanIds: entries.map(e => e.planId),
                registeredAt: params.registeredAt,
                dispatchedAt: null,
                closedAt: null,
            });
            return true;
        },
        updateCodingRoundAfterDispatch: async (roundId, dispatchedAt) => {
            const r = rounds.get(roundId);
            if (!r) return false;
            r.state = 'dispatched';
            if (dispatchedAt) r.dispatchedAt = dispatchedAt;
            return true;
        },
        closeCodingRoundIfOpen: async (roundId, closedAt) => {
            const r = rounds.get(roundId);
            if (!r) return false;
            if (r.state !== 'dispatched' && r.state !== 'partial') return false;
            r.state = 'closed';
            r.closedAt = closedAt;
            return true;
        },
        getConfigJson: async (key, fallback) => (opts.groups && key.includes('terminals.groups')) ? opts.groups : (fallback || []),
        ...(opts.db || {}),
    };

    const server = new LocalApiServer({
        clickupMetadataPath: '',
        linearMetadataPath: '',
        getClickUpService: () => null,
        getLinearService: () => null,
        getNotionService: () => null,
        getAuthToken: async () => 'test-token',
        allRoots: [WS],
        workspaceRoot: WS,
        getKanbanDatabase: async () => fakeDb,
        resolveTeamMembers: opts.resolveTeamMembers || (async () => ROSTER),
        resolveTeamPacing: async () => 'head',
        terminalVerb: opts.terminalVerb || (async (verb) => {
            if (verb === 'ptyListTerminals') {
                return { success: true, terminals: [
                    { friendlyName: LEAD, role: 'lead_coder' },
                    { friendlyName: 'Coding-coder-1', role: 'coder' },
                    { friendlyName: 'Coding-coder-2', role: 'coder' },
                ] };
            }
            return { success: true };
        }),
        clearTerminalContext: async (_ws, term) => { clears.push(term); return { cleared: true }; },
        onTeamReleased: async () => {},
        armQueueWatch: async () => {},
    });

    server.performKanbanDispatch = async (_ws, planId, _target, options) => {
        dispatched.push({ planId, seat: options?.targetTerminalOverride });
        return { status: 200, payload: { success: true, planId, dispatched: true } };
    };

    return { server, plans, rounds, inserted, dispatched, events, clears, fakeDb };
}

/** POST a JSON body at an endpoint through the real request handler. */
async function post(server, url, body) {
    const req = {
        method: 'POST',
        url,
        headers: {
            'content-type': 'application/json',
            'x-switchboard-client': 'contract-test',
            'authorization': 'Bearer test-token',
        },
        on: (event, cb) => {
            if (event === 'data') cb(Buffer.from(JSON.stringify(body)));
            else if (event === 'end') cb();
        },
        socket: { destroy: () => {}, remoteAddress: '127.0.0.1' },
    };
    let status = 0;
    let responseBody = null;
    const res = {
        writeHead: (code) => { status = code; },
        setHeader: () => {}, getHeader: () => undefined, getHeaders: () => ({}), removeHeader: () => {},
        end: (data) => { responseBody = data ? JSON.parse(data) : null; },
    };
    await server._handleRequest(req, res);
    return { status, body: responseBody };
}

const accept = (ctx, body) => post(ctx.server, '/kanban/task/complete', { from: LEAD, workspaceRoot: WS, ...body });
const register = (ctx, body) => post(ctx.server, '/kanban/round/register', { from: LEAD, workspaceRoot: WS, ...body });

/** Seed a feature held by LEAD with `n` subtasks s1..sn (feature order). */
function seedHeldFeature(ctx, n) {
    ctx.plans.set('feat-1', card('feat-1', { isFeature: true, ownerSeat: LEAD, kanbanColumn: 'CREATED', topic: 'The Feature' }));
    for (let i = 1; i <= n; i++) {
        ctx.plans.set(`s${i}`, card(`s${i}`, { featureId: 'feat-1', ownerSeat: `Coding-coder-${(i % 2) + 1}` }));
    }
}

async function run() {
    console.log('\naccept ordinal resolution contract\n');

    // ── 1. `accept <n>` resolves the nth subtask of the held feature ──────────

    await check('accept ordinal 3 accepts the THIRD subtask — not the most recently touched', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 3);
        // s1 was dispatched most recently — an implementation that quietly
        // picks "the latest" completes s1, not s3.
        ctx.plans.get('s1').ownerSince = '2026-09-21T12:00:00Z';
        ctx.plans.get('s2').ownerSince = '2026-09-21T10:00:00Z';
        ctx.plans.get('s3').ownerSince = '2026-09-21T11:00:00Z';

        const r = await accept(ctx, { ordinal: 3 });
        assert.strictEqual(r.status, 200, `accept 3 succeeded: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.planId, 's3', 'ordinal 3 resolved to the third subtask');
        assert.ok(ctx.plans.get('s3').completedAt, 's3 carries completed_at');
        assert.ok(!ctx.plans.get('s1').completedAt, 's1 untouched');
        assert.strictEqual(r.body.resolution.ordinal, 3, 'the echo names the ordinal');
        assert.strictEqual(r.body.resolution.title, 'topic-s3', 'and the resolved title');
        assert.strictEqual(r.body.resolution.featureId, 'feat-1', 'and the feature');
    });

    await check('bare accept resolves the single incomplete subtask', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 3);
        ctx.plans.get('s1').completedAt = '2026-09-21T10:00:00Z';
        ctx.plans.get('s2').completedAt = '2026-09-21T10:05:00Z';

        const r = await accept(ctx, {});
        assert.strictEqual(r.status, 200, `bare accept succeeded: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.planId, 's3', 'the one outstanding subtask resolved');
        assert.strictEqual(r.body.resolution.ordinal, 3, 'its FEATURE ordinal is reported, not a renumbered one');
    });

    await check('bare accept with two outstanding subtasks 400s naming both with ordinals', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 3);
        ctx.plans.get('s2').completedAt = '2026-09-21T10:00:00Z';

        const r = await accept(ctx, {});
        assert.strictEqual(r.status, 400, 'ambiguous bare accept refuses');
        assert.ok(/ambiguous/i.test(r.body.error), `the error says why: ${r.body.error}`);
        assert.ok(r.body.error.includes('1:') && r.body.error.includes('3:'),
            `the error IS the menu — ordinals and titles: ${r.body.error}`);
        assert.ok(r.body.error.includes('topic-s1') && r.body.error.includes('topic-s3'));
        assert.ok(!ctx.plans.get('s1').completedAt && !ctx.plans.get('s3').completedAt,
            'an ambiguous accept writes completed_at on NOTHING');
    });

    await check('bare accept with zero outstanding subtasks 400s naming the feature', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 2);
        ctx.plans.get('s1').completedAt = '2026-09-21T10:00:00Z';
        ctx.plans.get('s2').completedAt = '2026-09-21T10:05:00Z';

        const r = await accept(ctx, {});
        assert.strictEqual(r.status, 400);
        assert.ok(/The Feature/.test(r.body.error), `the error names the feature: ${r.body.error}`);
        assert.ok(/awaiting acceptance/i.test(r.body.error));
    });

    await check('an out-of-range ordinal 400s naming the valid range and writes nothing', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 2);

        const r = await accept(ctx, { ordinal: 5 });
        assert.strictEqual(r.status, 400);
        assert.ok(/out of range/i.test(r.body.error), `the error says range: ${r.body.error}`);
        assert.ok(r.body.error.includes('1-2'), `the error names the valid range: ${r.body.error}`);
        assert.ok(!ctx.plans.get('s1').completedAt && !ctx.plans.get('s2').completedAt,
            'no completed_at write on a refused ordinal');
    });

    await check('ordinals are stable across an accept — accept 1 then accept 3 hits the same third subtask', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 3);

        const r1 = await accept(ctx, { ordinal: 1 });
        assert.strictEqual(r1.status, 200);
        assert.strictEqual(r1.body.planId, 's1');

        const r3 = await accept(ctx, { ordinal: 3 });
        assert.strictEqual(r3.status, 200);
        assert.strictEqual(r3.body.planId, 's3',
            'the third ordinal still means the third subtask — accepting s1 did not shrink the list');
        assert.ok(ctx.plans.get('s3').completedAt);
    });

    await check('planId AND ordinal together is a 400, not a planId-with-hint', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 2);

        const r = await accept(ctx, { planId: 's1', ordinal: 2 });
        assert.strictEqual(r.status, 400);
        assert.ok(/mutually exclusive|not both/i.test(r.body.error), `the error names the conflict: ${r.body.error}`);
        assert.ok(!ctx.plans.get('s1').completedAt, 'nothing was completed');
    });

    await check('a non-integer ordinal is a 400 naming the field', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 2);
        for (const bad of [0, -2, 1.5, 'x', { planId: 's1' }]) {
            const r = await accept(ctx, { ordinal: bad });
            assert.strictEqual(r.status, 400, `ordinal ${JSON.stringify(bad)} must 400`);
            assert.ok(/ordinal/i.test(r.body.error), `the error names ordinal: ${r.body.error}`);
        }
        assert.ok(!ctx.plans.get('s1').completedAt && !ctx.plans.get('s2').completedAt);
    });

    await check('a poster associated with two open features gets a named 400 — never a quiet pick', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 2);
        // A second open feature also stamped to the lead.
        ctx.plans.set('feat-2', card('feat-2', { isFeature: true, ownerSeat: LEAD, topic: 'Other Feature' }));
        ctx.plans.set('t1', card('t1', { featureId: 'feat-2', ownerSeat: 'Coding-coder-1' }));

        const r = await accept(ctx, { ordinal: 1 });
        assert.strictEqual(r.status, 400);
        assert.ok(r.body.error.includes('The Feature') && r.body.error.includes('Other Feature'),
            `the error names BOTH features: ${r.body.error}`);
        assert.ok(!ctx.plans.get('s1').completedAt && !ctx.plans.get('t1').completedAt);
    });

    // ── 2. Non-feature candidates ─────────────────────────────────────────────

    await check("a planning seat's bare accept resolves its own held card — its team's other seats are not candidates", async () => {
        const ctx = makeServer({
            // The Planning group is headed by Planning-head; Planner-2 is a
            // MEMBER. Its candidate set is its own seat only.
            groups: [{ id: 'team_Planning-head', head: 'Planning-head', members: ['Planning-head', 'Planner-2', 'Planner-3'] }],
            resolveTeamMembers: async () => ['Planning-head', 'Planner-2', 'Planner-3'],
        });
        ctx.plans.set('plan-mine', card('plan-mine', { ownerSeat: 'Planner-2' }));
        ctx.plans.set('plan-other', card('plan-other', { ownerSeat: 'Planner-3' }));

        const r = await post(ctx.server, '/kanban/task/complete', { from: 'Planner-2', workspaceRoot: WS });
        assert.strictEqual(r.status, 200, `self-accept succeeded: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.planId, 'plan-mine', 'the poster resolves its own card');
        assert.ok(!ctx.plans.get('plan-other').completedAt, "a teammate's card is never the candidate");
    });

    await check('a bare accept from a seat holding nothing 400s with the named reason', async () => {
        const ctx = makeServer({ groups: [] });
        ctx.plans.set('plan-other', card('plan-other', { ownerSeat: 'Somebody-else' }));

        const r = await post(ctx.server, '/kanban/task/complete', { from: 'Planner-9', workspaceRoot: WS });
        assert.strictEqual(r.status, 400);
        assert.ok(r.body.error.includes('Planner-9'), `the error names the poster: ${r.body.error}`);
        assert.ok(!ctx.plans.get('plan-other').completedAt, 'no card was completed');
    });

    await check('a non-lead cannot accept another team\u2019s card — candidates come from the poster\u2019s own seat', async () => {
        const ctx = makeServer({ groups: [] });
        ctx.plans.set('plan-theirs', card('plan-theirs', { ownerSeat: 'Coding-coder-1' }));

        const r = await post(ctx.server, '/kanban/task/complete', { from: 'Outsider', ordinal: 1, workspaceRoot: WS });
        assert.strictEqual(r.status, 400, 'an outsider with no held work gets a named 400');
        assert.ok(!ctx.plans.get('plan-theirs').completedAt);
    });

    await check('a headed batch lead\u2019s accept <n> indexes the roster\u2019s cards by ownerSince — accepted cards keep their slot', async () => {
        const ctx = makeServer({
            groups: [{ id: 'team_Batch-head', head: 'Batch-head', members: ['Batch-head', 'Coder-A', 'Coder-B'] }],
            resolveTeamMembers: async () => ['Batch-head', 'Coder-A', 'Coder-B'],
        });
        // Three cards held by the roster, one already accepted. ownerSince
        // order is the printed order: done-card=1, old-card=2, new-card=3 —
        // the accepted card keeps its slot so ordinals do not shift mid-run.
        ctx.plans.set('new-card', card('new-card', { ownerSeat: 'Coder-B', ownerSince: '2026-09-21T11:00:00Z' }));
        ctx.plans.set('old-card', card('old-card', { ownerSeat: 'Coder-A', ownerSince: '2026-09-21T09:00:00Z' }));
        ctx.plans.set('done-card', card('done-card', { ownerSeat: 'Coder-A', ownerSince: '2026-09-21T08:00:00Z', completedAt: '2026-09-21T08:30:00Z' }));

        const r = await post(ctx.server, '/kanban/task/complete', { from: 'Batch-head', ordinal: 2, workspaceRoot: WS });
        assert.strictEqual(r.status, 200, `accept 2 succeeded: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.planId, 'old-card', 'ordinal 2 is the second card in the printed list');
        assert.ok(ctx.plans.get('old-card').completedAt);
        assert.ok(!ctx.plans.get('new-card').completedAt, 'ordinal 3 was not consumed');

        // Bare accept now resolves the single remaining incomplete card.
        const r2 = await post(ctx.server, '/kanban/task/complete', { from: 'Batch-head', workspaceRoot: WS });
        assert.strictEqual(r2.status, 200, `bare accept succeeded: ${JSON.stringify(r2.body)}`);
        assert.strictEqual(r2.body.planId, 'new-card', 'the one outstanding card resolved');
        assert.strictEqual(r2.body.resolution.ordinal, 3, 'its slot in the stable list is reported');
    });

    // ── 3. round/register takes ordinals and derives the feature ──────────────

    await check('round/register with ordinal rounds and no featureId registers against the held feature', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 3);

        const r = await register(ctx, { rounds: [[1, 2], [3]] });
        assert.strictEqual(r.status, 200, `register succeeded: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.featureId, 'feat-1', 'the feature was derived from the held card');
        assert.deepStrictEqual(ctx.inserted[0].subtasks.map(s => s.planId), ['s1', 's2'],
            'ordinals stored as planIds — subtask_seats shape unchanged');
        assert.deepStrictEqual(ctx.inserted[1].subtasks.map(s => s.planId), ['s3']);
        assert.strictEqual(ctx.rounds.get(ctx.inserted[0].roundId).state, 'dispatched',
            'registration still starts round 1');
    });

    await check('round/register mixes ordinals, numeric strings, planIds and seat-pinned ordinals', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 3);

        const r = await register(ctx, { rounds: [[1, 's2'], [{ ordinal: 3, seat: 'Coding-coder-1' }]] });
        assert.strictEqual(r.status, 200, `mixed form registers: ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual(ctx.inserted[0].subtasks, [
            { planId: 's1', seat: null },
            { planId: 's2', seat: null },
        ]);
        assert.deepStrictEqual(ctx.inserted[1].subtasks, [
            { planId: 's3', seat: 'Coding-coder-1' },
        ], 'an ordinal entry still carries the lead\u2019s seat pin');
    });

    await check('a bad register ordinal 400s naming the entry and the valid range', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 2);

        const r = await register(ctx, { rounds: [[1, 7]] });
        assert.strictEqual(r.status, 400);
        assert.ok(/Round 1/.test(r.body.error) && /7/.test(r.body.error) && /1-2/.test(r.body.error),
            `the error names the round, the entry, and the range: ${r.body.error}`);
        assert.strictEqual(ctx.inserted.length, 0, 'nothing was registered');
    });

    await check('a register with no featureId and no held feature 400s the same shape as a missing field', async () => {
        const ctx = makeServer();
        // No feature card held by LEAD.
        ctx.plans.set('s1', card('s1', { ownerSeat: 'Coding-coder-1' }));

        const r = await register(ctx, { rounds: [[1]] });
        assert.strictEqual(r.status, 400);
        assert.ok(/featureId/.test(r.body.error), `the error names the missing field: ${r.body.error}`);
        assert.ok(r.body.error.includes(LEAD), 'and the poster it could not derive for');
    });

    await check('an explicit featureId still registers planIds exactly as before', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 2);

        const r = await register(ctx, { featureId: 'feat-1', rounds: [['s1'], ['s2']] });
        assert.strictEqual(r.status, 200, `explicit-featureId register succeeded: ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual(ctx.inserted[0].subtasks.map(s => s.planId), ['s1']);
        assert.deepStrictEqual(ctx.inserted[1].subtasks.map(s => s.planId), ['s2']);
    });

    await check('duplicate ordinals across rounds still 400 as duplicates', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 3);

        const r = await register(ctx, { rounds: [[1, 2], ['s2', 3]] });
        assert.strictEqual(r.status, 400, 'ordinal 2 and planId s2 name the same subtask — a cross-round duplicate');
        assert.ok(/multiple rounds|duplicate/i.test(r.body.error), `the error names the duplicate: ${r.body.error}`);
        assert.strictEqual(ctx.inserted.length, 0);
    });

    // ── Summary ──────────────────────────────────────────────────────────────

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
