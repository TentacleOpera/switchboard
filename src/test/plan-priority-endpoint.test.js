'use strict';

/**
 * PUT /kanban/plans/priority — the agent-reachable priority-star write path.
 *
 * The star shipped reachable only over the generic `/kanban/verb/*` rail, and
 * `_handleKanbanVerb` performs NO payload validation — it deletes `type` and
 * hands the body straight to the provider. So an agent that sent the wrong
 * field name, or `starred: "false"` (which `!!` turns into `true`), got a
 * hollow `{success:true}` and the opposite of what it asked for. This suite is
 * the behavioural half of that contract: the source-text invariants live in
 * `card-priority-and-column-order-contract.test.js`, but only a real request
 * proves the ladder actually rejects and the write actually lands.
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

const WS = '/tmp/plan-priority-endpoint-ws';
const WS_ID = 'ws-1';

/**
 * A LocalApiServer over a fake DB that reproduces the two properties which make
 * this endpoint's honesty non-obvious:
 *   - the plan lookups are NOT workspace-scoped (they are `WHERE plan_id = ?`);
 *   - `setPriorityStarred` IS scoped, and `_persistedUpdate` returns true even
 *     when the UPDATE matched zero rows.
 * Together those turn a wrong workspace id into a reported-but-unwritten star.
 */
function makeServer(opts = {}) {
    const plans = new Map(); // planId → { planId, sessionId, workspaceId, priorityStarred }
    const writes = [];       // every setPriorityStarred call, landed or not

    const fakeDb = {
        getWorkspaceId: async () => opts.serverWsId !== undefined ? opts.serverWsId : WS_ID,
        getDominantWorkspaceId: async () => opts.serverWsId !== undefined ? opts.serverWsId : WS_ID,
        getPlanByPlanId: async (planId) => plans.get(planId) || null,
        getPlanBySessionId: async (sessionId) => {
            for (const p of plans.values()) {
                if (p.sessionId === sessionId) return p;
            }
            return null;
        },
        // Mirrors KanbanDatabase: scoped UPDATE, and true even on zero rows.
        setPriorityStarred: async (planId, workspaceId, starred) => {
            writes.push({ planId, workspaceId, starred });
            const p = plans.get(planId);
            if (p && p.workspaceId === workspaceId) {
                p.priorityStarred = starred ? 1 : 0;
            }
            return true;
        },
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
        armQueueWatch: async () => {},
    });

    return { server, plans, writes };
}

function plan(planId, extra = {}) {
    return { planId, sessionId: planId, workspaceId: WS_ID, priorityStarred: 0, planFile: `${planId}.md`, ...extra };
}

async function putPriority(server, body, authToken) {
    const headers = { 'content-type': 'application/json' };
    // Deliberately NOT a default parameter: an explicit `undefined` must omit the
    // header entirely, which is what the unauthenticated case is testing.
    if (authToken !== undefined) headers['authorization'] = `Bearer ${authToken}`;
    const req = {
        method: 'PUT',
        url: '/kanban/plans/priority',
        headers,
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
        setHeader: () => {},
        end: (data) => { responseBody = data ? JSON.parse(data) : null; },
    };
    await server._handleRequest(req, res);
    return { status, body: responseBody };
}

async function run() {
    console.log('\nPUT /kanban/plans/priority\n');

    // ── The happy path ───────────────────────────────────────────────────

    await check('a boolean true stars the plan and reports it honestly', async () => {
        const { server, plans } = makeServer();
        plans.set('p1', plan('p1'));
        const r = await putPriority(server, { planId: 'p1', starred: true }, 'test-token');
        assert.strictEqual(r.status, 200, 'valid call returns 200');
        assert.strictEqual(r.body.success, true);
        assert.strictEqual(r.body.planId, 'p1', 'the response echoes the canonical planId');
        assert.strictEqual(r.body.starred, true);
        assert.strictEqual(plans.get('p1').priorityStarred, 1, 'the star actually landed');
    });

    await check('a boolean false clears the star', async () => {
        const { server, plans } = makeServer();
        plans.set('p1', plan('p1', { priorityStarred: 1 }));
        const r = await putPriority(server, { planId: 'p1', starred: false }, 'test-token');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.starred, false);
        assert.strictEqual(plans.get('p1').priorityStarred, 0, 'the star actually cleared');
    });

    await check('the write is idempotent', async () => {
        const { server, plans } = makeServer();
        plans.set('p1', plan('p1'));
        await putPriority(server, { planId: 'p1', starred: true }, 'test-token');
        const r = await putPriority(server, { planId: 'p1', starred: true }, 'test-token');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(plans.get('p1').priorityStarred, 1);
    });

    // ── Strict boolean coercion — the trap this endpoint exists to close ──

    await check('starred: "false" clears the star — it is never coerced to true', async () => {
        // The whole reason this endpoint exists. `!!"false"` is `true`, so the old
        // verb-rail path STARRED a plan the agent asked to unstar. The plan's
        // Verification Plan says this should 400, but its authoritative
        // "Replaced with" spec, its Proposed Changes code and the shipped SKILL.md
        // row all accept "true"/"false" case-insensitively — and refusing "false"
        // while accepting "true" would be incoherent for the same type. What must
        // never happen is the silent inversion; that is what is pinned here.
        const { server, plans } = makeServer();
        plans.set('p1', plan('p1', { priorityStarred: 1 }));
        const r = await putPriority(server, { planId: 'p1', starred: 'false' }, 'test-token');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.starred, false, '"false" must resolve to false, never to true');
        assert.strictEqual(plans.get('p1').priorityStarred, 0, 'the star must actually clear');
    });

    await check('starred: "FALSE" and " False " also clear the star', async () => {
        for (const raw of ['FALSE', ' False ']) {
            const { server, plans } = makeServer();
            plans.set('p1', plan('p1', { priorityStarred: 1 }));
            const r = await putPriority(server, { planId: 'p1', starred: raw }, 'test-token');
            assert.strictEqual(r.status, 200, `${JSON.stringify(raw)} is accepted`);
            assert.strictEqual(r.body.starred, false);
            assert.strictEqual(plans.get('p1').priorityStarred, 0);
        }
    });

    await check('starred: "true" / "TRUE" resolve to true', async () => {
        for (const raw of ['true', 'TRUE', ' True ']) {
            const { server, plans } = makeServer();
            plans.set('p1', plan('p1'));
            const r = await putPriority(server, { planId: 'p1', starred: raw }, 'test-token');
            assert.strictEqual(r.status, 200, `${JSON.stringify(raw)} is accepted`);
            assert.strictEqual(r.body.starred, true);
            assert.strictEqual(plans.get('p1').priorityStarred, 1);
        }
    });

    await check('starred: 1 and 0 resolve to true and false', async () => {
        const { server, plans } = makeServer();
        plans.set('p1', plan('p1'));
        let r = await putPriority(server, { planId: 'p1', starred: 1 }, 'test-token');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.starred, true);
        assert.strictEqual(plans.get('p1').priorityStarred, 1);

        r = await putPriority(server, { planId: 'p1', starred: 0 }, 'test-token');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.starred, false);
        assert.strictEqual(plans.get('p1').priorityStarred, 0);
    });

    await check('starred: "maybe" is refused with an honest 400', async () => {
        const { server } = makeServer();
        const r = await putPriority(server, { planId: 'p1', starred: 'maybe' }, 'test-token');
        assert.strictEqual(r.status, 400);
        assert.ok(/boolean/.test(r.body.error), 'the error names the accepted forms');
    });

    await check('a non-scalar starred is refused', async () => {
        const { server, plans } = makeServer();
        plans.set('p1', plan('p1'));
        for (const raw of [{}, [], 7]) {
            const r = await putPriority(server, { planId: 'p1', starred: raw }, 'test-token');
            assert.strictEqual(r.status, 400, `${JSON.stringify(raw)} must be refused`);
        }
        assert.strictEqual(plans.get('p1').priorityStarred, 0);
    });

    await check('a missing starred field is refused, not treated as false', async () => {
        const { server, plans } = makeServer();
        plans.set('p1', plan('p1', { priorityStarred: 1 }));
        const r = await putPriority(server, { planId: 'p1' }, 'test-token');
        assert.strictEqual(r.status, 400);
        assert.strictEqual(plans.get('p1').priorityStarred, 1, 'an omitted field must not silently unstar');
    });

    // ── Identity resolution ──────────────────────────────────────────────

    await check('sessionId is accepted as an alias for planId', async () => {
        const { server, plans } = makeServer();
        plans.set('p1', plan('p1', { sessionId: 'sess-9' }));
        const r = await putPriority(server, { sessionId: 'sess-9', starred: true }, 'test-token');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.planId, 'p1', 'the response returns the canonical planId, not the session id');
        assert.strictEqual(plans.get('p1').priorityStarred, 1);
    });

    await check('a missing planId is refused', async () => {
        const { server } = makeServer();
        const r = await putPriority(server, { starred: true }, 'test-token');
        assert.strictEqual(r.status, 400);
    });

    await check('an unknown planId is a 404, not a hollow success', async () => {
        const { server } = makeServer();
        const r = await putPriority(server, { planId: 'does-not-exist', starred: true }, 'test-token');
        assert.strictEqual(r.status, 404);
    });

    // ── Workspace scoping ────────────────────────────────────────────────

    await check('a plan from another workspace in the same DB is really starred', async () => {
        // The lookups are unscoped, so this row IS found; the UPDATE is scoped and
        // reports success on zero rows. Keying the write to the server's own
        // workspace would answer 200 {success:true} for a star that never landed.
        const { server, plans, writes } = makeServer({ serverWsId: 'ws-other' });
        plans.set('p1', plan('p1', { workspaceId: WS_ID }));
        const r = await putPriority(server, { planId: 'p1', starred: true }, 'test-token');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(writes[0].workspaceId, WS_ID,
            "the write must be keyed to the resolved row's workspace, not the server's");
        assert.strictEqual(plans.get('p1').priorityStarred, 1,
            'a reported star that did not land is the exact silent no-op this endpoint replaced');
    });

    // ── Auth ─────────────────────────────────────────────────────────────

    await check('an unauthenticated call is refused with no write', async () => {
        const { server, plans } = makeServer();
        plans.set('p1', plan('p1'));
        const r = await putPriority(server, { planId: 'p1', starred: true }, undefined); // no header
        assert.strictEqual(r.status, 401);
        assert.strictEqual(plans.get('p1').priorityStarred, 0, 'no write on auth failure');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
