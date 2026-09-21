'use strict';

/**
 * Contract: `accept <n>` and bare `accept` resolve server-side — no planId,
 * no UUID, no identity argument.
 *
 * Plan: a-seat-says-submit-and-a-lead-says-accept-n.md (Goal, line 5).
 *
 * `<n>` is a LEAD'S TYPING SHORTCUT for indexing a feature file's numbered
 * Subtasks list. It is not a general addressing scheme, so headship gates it:
 *
 *  - LEAD (heads a team) HOLDING ONE OPEN FEATURE — the ordinal branch:
 *    `{ordinal: n}` accepts the nth subtask of that feature, asserted against
 *    a feature whose third subtask is NOT the most recently touched so
 *    "latest wins" fails; ordinals are STABLE across an accept and across a
 *    `submit` that CLEARED the subtask's ownerSeat; out-of-range 400s naming
 *    the range and writes nothing; bare `accept` resolves only when exactly
 *    one subtask is incomplete, and 400s naming the menu otherwise; two open
 *    features is a named 400, never a quiet pick.
 *  - EVERYONE ELSE — the own-card branch: the ONE card the poster's own seat
 *    holds. Any ordinal is DROPPED (not honoured, not an error, and absent
 *    from the success echo); zero held cards and many held cards are each a
 *    named 400. A teammate's card is never a candidate, and a batch head
 *    holding no feature gets the same honest "you hold nothing" as any seat.
 *
 * The own-card branch is asserted against the two fixtures the live board
 * actually has and the old roster-wide list did not model: a card whose
 * `ownerSeat` was cleared by `submit`, and cards with NULL `ownerSince`.
 * Both must be harmless here — there is no ordering and no roster to corrupt.
 *
 *  - `planId` + `ordinal` together is a 400, not a planId-with-hint;
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
    const groups = opts.groups !== undefined
        ? opts.groups
        : [{ id: 'team_Coding', head: LEAD, members: ROSTER }];
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
        // Headship gates the ordinal branch, so the default harness makes
        // LEAD an actual head. `opts.groups: []` (explicit) still yields a
        // poster that heads nothing — that is how the own-card branch is
        // reached.
        getConfigJson: async (key, fallback) => (groups && key.includes('terminals.groups')) ? groups : (fallback || []),
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

    // ── 2. The own-card branch — everyone who is not a lead with a feature ──

    await check("a planning seat's bare accept resolves its own held card — its team's other seats are not candidates", async () => {
        const ctx = makeServer({
            // The Planning group is headed by Planning-head; Planner-2 is a
            // MEMBER, so it heads nothing and lands on the own-card branch.
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

    await check('a NON-LEAD posting `accept 3` accepts its own single held card — the ordinal is dropped, not honoured, not an error', async () => {
        const ctx = makeServer({
            groups: [{ id: 'team_Planning-head', head: 'Planning-head', members: ['Planning-head', 'Planner-2'] }],
        });
        ctx.plans.set('plan-mine', card('plan-mine', { ownerSeat: 'Planner-2', topic: 'my only card' }));

        const r = await post(ctx.server, '/kanban/task/complete', { from: 'Planner-2', ordinal: 3, workspaceRoot: WS });
        assert.strictEqual(r.status, 200, `accept 3 from a non-lead is NOT an error: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.planId, 'plan-mine', 'it resolved the seat\u2019s own held card');
        assert.ok(ctx.plans.get('plan-mine').completedAt, 'the card was accepted');
        // The drop must not be dressed up as a hit: no ordinal in the echo.
        assert.strictEqual(r.body.resolution.ordinal, undefined,
            `the success echo must NOT claim an ordinal was honoured: ${JSON.stringify(r.body.resolution)}`);
        assert.strictEqual(r.body.resolution.title, 'my only card', 'it still names what was accepted');
        assert.ok(!('featureId' in r.body.resolution), 'and reports no feature — there is none');
    });

    await check('a NON-LEAD holding nothing gets a 400 naming that it holds nothing — an ordinal does not conjure a card', async () => {
        const ctx = makeServer({ groups: [] });
        ctx.plans.set('plan-other', card('plan-other', { ownerSeat: 'Somebody-else' }));

        for (const body of [{}, { ordinal: 1 }, { ordinal: 7 }]) {
            const r = await post(ctx.server, '/kanban/task/complete', { from: 'Planner-9', workspaceRoot: WS, ...body });
            assert.strictEqual(r.status, 400, `${JSON.stringify(body)} must 400`);
            assert.ok(r.body.error.includes('Planner-9'), `the error names the poster: ${r.body.error}`);
            assert.ok(/holds no card awaiting acceptance/i.test(r.body.error),
                `the error says the seat holds nothing — not that a list was empty: ${r.body.error}`);
            assert.ok(!ctx.plans.get('plan-other').completedAt, 'no card was completed');
        }
    });

    await check('a non-lead cannot accept another team\u2019s card — candidates come from the poster\u2019s own seat', async () => {
        const ctx = makeServer({ groups: [] });
        ctx.plans.set('plan-theirs', card('plan-theirs', { ownerSeat: 'Coding-coder-1' }));

        const r = await post(ctx.server, '/kanban/task/complete', { from: 'Outsider', ordinal: 1, workspaceRoot: WS });
        assert.strictEqual(r.status, 400, 'an outsider with no held work gets a named 400');
        assert.ok(!ctx.plans.get('plan-theirs').completedAt);
    });

    await check('a seat holding TWO incomplete cards gets a 400 listing both and naming --plan', async () => {
        const ctx = makeServer({ groups: [] });
        ctx.plans.set('card-a', card('card-a', { ownerSeat: 'Planner-2', topic: 'first thing' }));
        ctx.plans.set('card-b', card('card-b', { ownerSeat: 'Planner-2', topic: 'second thing' }));

        const r = await post(ctx.server, '/kanban/task/complete', { from: 'Planner-2', ordinal: 2, workspaceRoot: WS });
        assert.strictEqual(r.status, 400, 'the ordinal cannot break the tie — it was never an index into this list');
        assert.ok(r.body.error.includes('first thing') && r.body.error.includes('second thing'),
            `the error names both cards: ${r.body.error}`);
        assert.ok(/--plan/.test(r.body.error), `and hands over the escape hatch: ${r.body.error}`);
        assert.ok(!ctx.plans.get('card-a').completedAt && !ctx.plans.get('card-b').completedAt,
            'an ambiguous accept writes completed_at on NOTHING');
    });

    await check('a HEADED batch lead holding no feature gets the honest "you hold nothing" — never a roster seat\u2019s card', async () => {
        // The old rule indexed the whole roster here, so `accept 2` silently
        // accepted a card belonging to Coder-A. A batch head holds no feature,
        // so the ordinal is dropped and only its OWN seat is asked.
        const ctx = makeServer({
            groups: [{ id: 'team_Batch-head', head: 'Batch-head', members: ['Batch-head', 'Coder-A', 'Coder-B'] }],
            resolveTeamMembers: async () => ['Batch-head', 'Coder-A', 'Coder-B'],
        });
        ctx.plans.set('new-card', card('new-card', { ownerSeat: 'Coder-B', ownerSince: '2026-09-21T11:00:00Z' }));
        ctx.plans.set('old-card', card('old-card', { ownerSeat: 'Coder-A', ownerSince: '2026-09-21T09:00:00Z' }));

        const r = await post(ctx.server, '/kanban/task/complete', { from: 'Batch-head', ordinal: 2, workspaceRoot: WS });
        assert.strictEqual(r.status, 400, `the head holds no card of its own: ${JSON.stringify(r.body)}`);
        assert.ok(!ctx.plans.get('old-card').completedAt && !ctx.plans.get('new-card').completedAt,
            'no roster seat\u2019s card was accepted on the head\u2019s behalf');
        assert.ok(/heads no open feature/.test(r.body.error),
            `the error says why the ordinal did not apply: ${r.body.error}`);
    });

    await check('a HEAD accepts its own held card when it heads no open feature', async () => {
        const ctx = makeServer({
            groups: [{ id: 'team_Batch-head', head: 'Batch-head', members: ['Batch-head', 'Coder-A'] }],
        });
        ctx.plans.set('head-card', card('head-card', { ownerSeat: 'Batch-head', topic: 'the head\u2019s own plan' }));
        ctx.plans.set('coder-card', card('coder-card', { ownerSeat: 'Coder-A' }));

        const r = await post(ctx.server, '/kanban/task/complete', { from: 'Batch-head', workspaceRoot: WS });
        assert.strictEqual(r.status, 200, `the head\u2019s self-accept resolves: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.planId, 'head-card');
        assert.ok(!ctx.plans.get('coder-card').completedAt, 'the roster is still not the candidate pool');
    });

    // ── 2b. The fixtures the live board has and the old list did not model ──

    await check('NULL ownerSince on every card is harmless — the own-card branch has no ordering to corrupt', async () => {
        // 284 of 292 owned cards on the live board carry NULL owner_since,
        // because a column move nulls it. The old list sorted on it.
        const ctx = makeServer({ groups: [] });
        ctx.plans.set('mine', card('mine', { ownerSeat: 'Planner-2', ownerSince: null, topic: 'null-since card' }));
        ctx.plans.set('theirs', card('theirs', { ownerSeat: 'Planner-3', ownerSince: null }));

        const r = await post(ctx.server, '/kanban/task/complete', { from: 'Planner-2', workspaceRoot: WS });
        assert.strictEqual(r.status, 200, `a NULL ownerSince still resolves: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.planId, 'mine');
        assert.ok(!ctx.plans.get('theirs').completedAt);
    });

    await check('a card whose ownerSeat was CLEARED by submit is not the poster\u2019s — and its absence is a named 400, not a wrong accept', async () => {
        // `submit` calls clearOwnerStamp, which sets owner_seat = ''. An empty
        // ownerSeat must never match a poster: it means "nobody holds this".
        const ctx = makeServer({ groups: [] });
        ctx.plans.set('submitted', card('submitted', { ownerSeat: '', topic: 'handed back' }));

        const r = await post(ctx.server, '/kanban/task/complete', { from: 'Planner-2', workspaceRoot: WS });
        assert.strictEqual(r.status, 400, 'a cleared stamp is not a match for an empty poster name either');
        assert.ok(/holds no card awaiting acceptance/i.test(r.body.error), r.body.error);
        assert.ok(!ctx.plans.get('submitted').completedAt, 'the handed-back card was not silently accepted');
    });

    await check('a submit-cleared subtask does NOT shift the feature\u2019s ordinals — accept 3 is still the third', async () => {
        // The clearOwnerStamp finding, proven rather than asserted: the
        // feature branch indexes getSubtasksByFeatureId, which does not
        // consult ownerSeat at all.
        const ctx = makeServer();
        seedHeldFeature(ctx, 3);
        ctx.plans.get('s1').ownerSeat = '';   // submitted, stamp cleared
        ctx.plans.get('s2').ownerSeat = '';   // submitted, stamp cleared
        ctx.plans.get('s3').ownerSince = null;

        const r = await accept(ctx, { ordinal: 3 });
        assert.strictEqual(r.status, 200, `accept 3 survives two cleared stamps: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.planId, 's3', 'the third subtask is still the third');
        assert.strictEqual(r.body.resolution.ordinal, 3, 'and the echo names the honoured ordinal');
        assert.ok(!ctx.plans.get('s1').completedAt && !ctx.plans.get('s2').completedAt);
    });

    await check('a lead\u2019s accept 3 hits the third subtask even when the third is the LEAST recently submitted', async () => {
        const ctx = makeServer();
        seedHeldFeature(ctx, 3);
        // s3 was submitted first and its stamp cleared longest ago; s1 is the
        // freshest. "Most recently submitted" and "oldest held" both fail.
        ctx.plans.get('s1').ownerSince = '2026-09-21T12:00:00Z';
        ctx.plans.get('s2').ownerSince = '2026-09-21T11:00:00Z';
        ctx.plans.get('s3').ownerSeat = '';
        ctx.plans.get('s3').ownerSince = null;

        const r = await accept(ctx, { ordinal: 3 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.planId, 's3');
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
