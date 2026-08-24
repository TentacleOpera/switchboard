'use strict';

/**
 * POST /kanban/task/complete — the asserted completion signal.
 *
 * Tests the endpoint's contract: idempotency, auth, validation, and the
 * in-flight scan honouring completed_at. See
 * `add-a-task-complete-endpoint-for-the-lead.md`.
 */

const assert = require('assert');
const path = require('path');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { LocalApiServer } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));

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

const WS = '/tmp/task-complete-endpoint-ws';

/** A board row shaped the way `getBoard` returns them. */
function card(planId, kanbanColumn, extra = {}) {
    return {
        planId,
        sessionId: planId,
        topic: planId,
        kanbanColumn,
        featureId: '',
        dispatchedAt: null,
        dispatchedTerminal: '',
        queuePosition: null,
        completedAt: null,
        ...extra,
    };
}

/**
 * A LocalApiServer wired with stub seams for the task/complete tests.
 * The fake DB records completed_at writes and supports getPlanByPlanId.
 */
function makeServer(opts = {}) {
    const plans = new Map(); // planId → { ...record, completedAt }
    const events = [];       // plan_events recordings
    const dispatched = [];

    const fakeDb = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => opts.board || [],
        getPlanByPlanId: async (planId) => plans.get(planId) || null,
        setCompletedAt: async (planId, timestamp) => {
            const p = plans.get(planId);
            if (!p) return false;
            p.completedAt = timestamp;
            p.updatedAt = timestamp;
            plans.set(planId, p);
            return true;
        },
        appendPlanEventByPlanId: async (planId, event) => {
            events.push({ planId, ...event });
            return true;
        },
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
        resolveTeamMembers: opts.resolveTeamMembers || (async () => ['Coding', 'Coder-1']),
        resolveTeamPacing: opts.resolveTeamPacing || (async () => 'head'),
        getRegisteredTerminals: opts.getRegisteredTerminals,
        armQueueWatch: async () => {},
    });

    server.performKanbanDispatch = async (workspaceRoot, planId) => {
        dispatched.push(planId);
        return { status: 200, payload: { success: true, planId, dispatched: true } };
    };

    return { server, plans, events, dispatched, fakeDb };
}

/** Make an HTTP request to the server's task/complete endpoint. */
async function postComplete(server, body, authToken) {
    const headers = { 'content-type': 'application/json' };
    if (authToken !== undefined) {
        headers['authorization'] = `Bearer ${authToken}`;
    }
    const req = {
        method: 'POST',
        url: '/kanban/task/complete',
        headers,
        on: (event, cb) => {
            if (event === 'data') {
                cb(Buffer.from(JSON.stringify(body)));
            } else if (event === 'end') {
                cb();
            }
        },
        socket: { destroy: () => {}, remoteAddress: '127.0.0.1' },
    };
    let status = 0;
    let responseBody = null;
    const res = {
        writeHead: (code) => { status = code; },
        setHeader: () => {},
        end: (data) => { responseBody = data ? JSON.parse(data) : null; },
    };
    await server._handleRequest(req, res);
    return { status, body: responseBody };
}

async function run() {
    console.log('\ntask-complete endpoint\n');

    // ── Idempotency ──────────────────────────────────────────────────────

    await check('idempotent: two identical calls produce one write', async () => {
        const { server, plans, events } = makeServer();
        plans.set('plan-1', card('plan-1', 'CODER CODED', { dispatchedTerminal: 'Coder-1' }));

        const r1 = await postComplete(server, { from: 'Coding', planId: 'plan-1' }, 'test-token');
        assert.strictEqual(r1.status, 200, 'first call succeeds');
        assert.strictEqual(r1.body.success, true);
        assert.ok(r1.body.completed_at, 'completed_at is set');
        assert.strictEqual(r1.body.idempotent, undefined, 'first call is not idempotent flag');

        const firstTimestamp = plans.get('plan-1').completedAt;
        const firstEventCount = events.length;

        const r2 = await postComplete(server, { from: 'Coding', planId: 'plan-1' }, 'test-token');
        assert.strictEqual(r2.status, 200, 'second call succeeds');
        assert.strictEqual(r2.body.idempotent, true, 'second call is flagged idempotent');
        assert.strictEqual(r2.body.completed_at, firstTimestamp, 'timestamp unchanged on repeat');
        assert.strictEqual(events.length, firstEventCount, 'no second event recorded');
    });

    // ── Auth ─────────────────────────────────────────────────────────────

    await check('unauthenticated call refused', async () => {
        const { server, plans } = makeServer();
        plans.set('plan-2', card('plan-2', 'CODER CODED'));

        const r = await postComplete(server, { from: 'Coding', planId: 'plan-2' }, undefined);
        assert.strictEqual(r.status, 401, 'unauthenticated returns 401');
        assert.strictEqual(plans.get('plan-2').completedAt, null, 'no write on auth failure');
    });

    // ── Validation ───────────────────────────────────────────────────────

    await check('planId with path separators refused', async () => {
        const { server, plans } = makeServer();
        plans.set('evil/../../etc/passwd', card('evil/../../etc/passwd', 'CODER CODED'));

        const r = await postComplete(server, { from: 'Coding', planId: 'evil/../../etc/passwd' }, 'test-token');
        assert.strictEqual(r.status, 400, 'path separator in planId returns 400');
        assert.strictEqual(r.body.error.includes('path separators'), true, 'error mentions path separators');
    });

    await check('planId with backslash refused', async () => {
        const { server } = makeServer();
        const r = await postComplete(server, { from: 'Coding', planId: 'evil\\path' }, 'test-token');
        assert.strictEqual(r.status, 400, 'backslash in planId returns 400');
    });

    await check('missing from field refused', async () => {
        const { server } = makeServer();
        const r = await postComplete(server, { planId: 'plan-3' }, 'test-token');
        assert.strictEqual(r.status, 400);
    });

    await check('missing planId field refused', async () => {
        const { server } = makeServer();
        const r = await postComplete(server, { from: 'Coding' }, 'test-token');
        assert.strictEqual(r.status, 400);
    });

    // ── No dispatch, no column move ──────────────────────────────────────

    await check('no dispatch side effect: no terminal receives a prompt', async () => {
        const { server, plans, dispatched } = makeServer();
        plans.set('plan-4', card('plan-4', 'CODER CODED', { dispatchedTerminal: 'Coder-1' }));

        const r = await postComplete(server, { from: 'Coding', planId: 'plan-4' }, 'test-token');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(dispatched, [], 'no dispatch occurred');
    });

    await check('no column move: card stays in its coding column', async () => {
        const { server, plans } = makeServer();
        plans.set('plan-5', card('plan-5', 'CODER CODED', { dispatchedTerminal: 'Coder-1' }));

        await postComplete(server, { from: 'Coding', planId: 'plan-5' }, 'test-token');
        assert.strictEqual(plans.get('plan-5').kanbanColumn, 'CODER CODED', 'column unchanged');
    });

    // ── In-flight scan honours completed_at ──────────────────────────────

    await check('board scan honours completed_at: completed card in coding column does not pin team', async () => {
        const board = [
            card('done-card', 'CODER CODED', { dispatchedTerminal: 'Coder-1', completedAt: '2026-08-24T12:00:00Z' }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer({
            board,
            resolveTeamMembers: async () => ['Coding', 'Coder-1'],
            resolveTeamPacing: async () => 'head',
        });

        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, 'pop succeeds — completed card does not pin the team');
        assert.deepStrictEqual(dispatched, ['next'], 'the next queued card is dispatched');
    });

    await check('board scan: uncompleted card in coding column still pins team', async () => {
        const board = [
            card('busy-card', 'CODER CODED', { dispatchedTerminal: 'Coder-1', completedAt: null }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer({
            board,
            resolveTeamMembers: async () => ['Coding', 'Coder-1'],
            resolveTeamPacing: async () => 'head',
        });

        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'pop refused — uncompleted card pins the team');
        assert.deepStrictEqual(dispatched, [], 'nothing dispatched while team is in flight');
    });

    // ── Plan not found ───────────────────────────────────────────────────

    await check('nonexistent planId returns 404', async () => {
        const { server } = makeServer();
        const r = await postComplete(server, { from: 'Coding', planId: 'does-not-exist' }, 'test-token');
        assert.strictEqual(r.status, 404);
    });

    // ── Summary ──────────────────────────────────────────────────────────

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
