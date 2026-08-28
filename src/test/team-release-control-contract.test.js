'use strict';

/**
 * Contract tests for team release control:
 * - POST /kanban/team/release endpoint
 * - Shared completeCardInternal helper
 * - heldUnposted in ptyListTerminals
 * - heldByTeam module helper
 * - terminals.html/js contract invariants
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { LocalApiServer, heldByTeam } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));

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

const WS = '/tmp/team-release-control-ws';

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

function makeServer(opts = {}) {
    const plans = new Map();
    const events = [];
    const dispatched = [];
    const clears = [];

    const fakeDb = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => {
            if (opts.getBoard) return opts.getBoard();
            return opts.board || Array.from(plans.values());
        },
        getPlanByPlanId: async (planId) => plans.get(planId) || null,
        setCompletedAt: async (planId, timestamp) => {
            if (opts.failSetCompletedAt && opts.failSetCompletedAt.has(planId)) {
                return false;
            }
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
        resolveTeamMembers: opts.resolveTeamMembers || (async () => ['Coding', 'Coder-1', 'Coder-2']),
        resolveTeamPacing: opts.resolveTeamPacing || (async () => 'head'),
        getRegisteredTerminals: opts.getRegisteredTerminals,
        terminalVerb: opts.terminalVerb || (async (verb, body, root) => {
            if (verb === 'ptyListTerminals') {
                return {
                    success: true,
                    terminals: [
                        { friendlyName: 'Coding', role: 'lead_coder' },
                        { friendlyName: 'Coder-1', role: 'coder' },
                        { friendlyName: 'Coder-2', role: 'coder' },
                    ]
                };
            }
            return { success: true };
        }),
        clearTerminalContext: opts.clearTerminalContext || (async (_ws, term) => {
            clears.push(term);
            return { cleared: true };
        }),
        armQueueWatch: async () => {},
    });

    server.performKanbanDispatch = async (workspaceRoot, planId) => {
        dispatched.push(planId);
        return { status: 200, payload: { success: true, planId, dispatched: true } };
    };

    return { server, plans, events, dispatched, clears, fakeDb };
}

async function postRelease(server, body, authToken = 'test-token') {
    const headers = { 'content-type': 'application/json' };
    if (authToken !== undefined) {
        headers['authorization'] = `Bearer ${authToken}`;
    }
    const req = {
        method: 'POST',
        url: '/kanban/team/release',
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

async function postTaskComplete(server, body, authToken = 'test-token') {
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

async function postTerminalVerb(server, verb, body, authToken = 'test-token') {
    const headers = { 'content-type': 'application/json' };
    if (authToken !== undefined) {
        headers['authorization'] = `Bearer ${authToken}`;
    }
    const req = {
        method: 'POST',
        url: `/terminals/verb/${verb}`,
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
    console.log('\nteam-release-control contract tests\n');

    // ── 1. Release set equals in-flight refusal set ──────────────────────────
    await check('release set equals in-flight refusal set and unblocks queue/next', async () => {
        const { server, plans, dispatched } = makeServer();
        const card1 = card('held-card-1', 'CODER CODED', { dispatchedTerminal: 'Coder-1', routedTo: 'coder' });
        const card2 = card('held-card-2', 'CODER CODED', { dispatchedTerminal: 'Coder-2', routedTo: 'coder' });
        const staged = card('next-card', 'STAGING', { queuePosition: 1 });
        plans.set('held-card-1', card1);
        plans.set('held-card-2', card2);
        plans.set('next-card', staged);

        // First queue/next should 409 because team is in flight
        const pre = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(pre.status, 409, 'queue/next refuses in-flight team');

        // Operator release
        const rel = await postRelease(server, { from: 'Coding' });
        assert.strictEqual(rel.status, 200);
        assert.strictEqual(rel.body.success, true);
        assert.deepStrictEqual(rel.body.released.sort(), ['held-card-1', 'held-card-2'].sort());
        assert.strictEqual(plans.get('held-card-1').completedAt !== null, true);
        assert.strictEqual(plans.get('held-card-2').completedAt !== null, true);

        // Second queue/next should succeed and pop next-card
        const post = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(post.status, 200, 'queue/next succeeds after release');
        assert.deepStrictEqual(dispatched, ['next-card']);
    });

    // ── 2. Route ignores caller-supplied planIds ─────────────────────────────
    await check('POST /kanban/team/release ignores caller-supplied planIds', async () => {
        const { server, plans } = makeServer();
        plans.set('card-a', card('card-a', 'CODER CODED', { dispatchedTerminal: 'Coder-1', routedTo: 'coder' }));
        plans.set('unrelated-card', card('unrelated-card', 'CODER CODED', { dispatchedTerminal: 'OtherTeamCoder', routedTo: 'coder' }));

        const res = await postRelease(server, { from: 'Coding', planId: 'unrelated-card', planIds: ['unrelated-card'] });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.released, ['card-a']);
        assert.strictEqual(plans.get('unrelated-card').completedAt, null, 'unrelated card was NOT completed');
    });

    // ── 3. Partial failure leaves other releases intact ──────────────────────
    await check('partial failure in setCompletedAt reports in failed and completes rest', async () => {
        const failSetCompletedAt = new Set(['bad-card']);
        const { server, plans } = makeServer({ failSetCompletedAt });
        plans.set('good-card', card('good-card', 'CODER CODED', { dispatchedTerminal: 'Coder-1', routedTo: 'coder' }));
        plans.set('bad-card', card('bad-card', 'CODER CODED', { dispatchedTerminal: 'Coder-2', routedTo: 'coder' }));

        const res = await postRelease(server, { from: 'Coding' });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.released, ['good-card']);
        assert.strictEqual(res.body.failed.length, 1);
        assert.strictEqual(res.body.failed[0].planId, 'bad-card');
        assert.strictEqual(plans.get('good-card').completedAt !== null, true);
        assert.strictEqual(plans.get('bad-card').completedAt, null);
    });

    // ── 4. Workflow marker: 'operator-release' vs 'task-complete' ───────────
    await check('plan_events records workflow: operator-release vs task-complete', async () => {
        const { server, plans, events } = makeServer();
        plans.set('op-card', card('op-card', 'CODER CODED', { dispatchedTerminal: 'Coder-1', routedTo: 'coder' }));
        // lead-card is NOT held by a team member — only task/complete touches it,
        // so its event records workflow 'task-complete', not 'operator-release'.
        plans.set('lead-card', card('lead-card', 'CODER CODED', { dispatchedTerminal: 'Unaffiliated', routedTo: 'coder' }));

        await postRelease(server, { from: 'Coding' });
        await postTaskComplete(server, { from: 'Coding', planId: 'lead-card' });

        const opEv = events.find(e => e.planId === 'op-card');
        const leadEv = events.find(e => e.planId === 'lead-card');

        assert.ok(opEv, 'operator release event exists');
        assert.strictEqual(opEv.workflow, 'operator-release');
        assert.strictEqual(opEv.eventType, 'completed');

        assert.ok(leadEv, 'task complete event exists');
        assert.strictEqual(leadEv.workflow, 'task-complete');
        assert.strictEqual(leadEv.eventType, 'completed');
    });

    // ── 5. Shared completeCardInternal called by both routes ─────────────────
    await check('shared completeCardInternal helper is called by task/complete and team/release', async () => {
        const { server, plans } = makeServer();
        plans.set('card-1', card('card-1', 'CODER CODED', { dispatchedTerminal: 'Coder-1', routedTo: 'coder' }));
        plans.set('card-2', card('card-2', 'CODER CODED', { dispatchedTerminal: 'Coder-2', routedTo: 'coder' }));

        const origComplete = server.completeCardInternal.bind(server);
        const calls = [];
        server.completeCardInternal = async (db, planId, from, opts) => {
            calls.push({ planId, from, workflow: opts.workflow });
            return await origComplete(db, planId, from, opts);
        };

        await postTaskComplete(server, { from: 'Coding', planId: 'card-1' });
        await postRelease(server, { from: 'Coding' });

        assert.strictEqual(calls.length, 2, 'both routes invoke completeCardInternal');
        assert.strictEqual(calls[0].planId, 'card-1');
        assert.strictEqual(calls[0].workflow, 'task-complete');
        assert.strictEqual(calls[1].planId, 'card-2');
        assert.strictEqual(calls[1].workflow, 'operator-release');
    });

    // ── 6. clearTerminalContext cleared for coder seats, lead skipped ───────
    await check('operator release clears coding seat context via clearTerminalContext', async () => {
        const { server, plans, clears } = makeServer();
        plans.set('coder-card', card('coder-card', 'CODER CODED', { dispatchedTerminal: 'Coder-1', routedTo: 'coder' }));

        await postRelease(server, { from: 'Coding' });
        assert.deepStrictEqual(clears, ['Coder-1'], 'Coder-1 context cleared, Coding head skipped');
    });

    // ── 7. heldUnposted in ptyListTerminals ──────────────────────────────────
    await check('ptyListTerminals returns heldUnposted per-terminal map', async () => {
        const { server, plans } = makeServer();
        plans.set('c1', card('c1', 'CODER CODED', { dispatchedTerminal: 'Coder-1' }));
        plans.set('c2', card('c2', 'CODER CODED', { dispatchedTerminal: 'Coder-1' }));
        plans.set('c3', card('c3', 'CODER CODED', { dispatchedTerminal: 'Coder-2' }));
        plans.set('c4', card('c4', 'CODER CODED', { dispatchedTerminal: 'Coder-2', completedAt: '2026-08-29T00:00:00Z' }));

        const res = await postTerminalVerb(server, 'ptyListTerminals', {});
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.heldUnposted, 'heldUnposted map present');
        assert.strictEqual(res.body.heldUnposted['Coder-1'], 2);
        assert.strictEqual(res.body.heldUnposted['Coder-2'], 1);
        assert.strictEqual(res.body.heldUnposted['Coding'], undefined);
    });

    // ── 8. heldByTeam module-level helper takes teamSet ─────────────────────
    await check('heldByTeam helper correctly evaluates card and teamSet parameter', async () => {
        const teamSet = new Set(['Coding', 'Coder-1']);
        const uncompletedHeld = { completedAt: null, dispatchedTerminal: 'Coder-1' };
        const completedHeld = { completedAt: '2026-08-29', dispatchedTerminal: 'Coder-1' };
        const otherHeld = { completedAt: null, dispatchedTerminal: 'Other' };
        const emptyHeld = { completedAt: null, dispatchedTerminal: '' };

        assert.strictEqual(heldByTeam(uncompletedHeld, teamSet), true);
        assert.strictEqual(heldByTeam(completedHeld, teamSet), false);
        assert.strictEqual(heldByTeam(otherHeld, teamSet), false);
        assert.strictEqual(heldByTeam(emptyHeld, teamSet), false);
        assert.strictEqual(heldByTeam(null, teamSet), false);
    });

    // ── 9. terminals.html and terminals.js source contract checks ───────────
    await check('terminals.html and terminals.js contract assertions', async () => {
        const html = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'terminals.html'), 'utf8');
        const js = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'terminals.js'), 'utf8');

        // HTML button is no longer ACKNOWLEDGE COMPLETIONS
        assert.ok(!html.includes('ACKNOWLEDGE COMPLETIONS'), 'ACKNOWLEDGE COMPLETIONS removed from terminals.html');
        assert.ok(html.includes('id="btn-team-ack"'), 'btn-team-ack present in terminals.html');

        // terminals.js visibility and label: RELEASE ${heldCount} HELD CARD...
        assert.ok(js.includes('RELEASE ${heldCount} HELD CARD'), 'dynamic count label in terminals.js');
        assert.ok(js.includes('btnTeamAck.hidden = !teamScopeId || heldCount === 0'), 'hidden when count is 0 in terminals.js');

        // terminals.js click listener calls releaseTeamHeldCards
        assert.ok(js.includes("btnTeamAck.addEventListener('click', () => releaseTeamHeldCards())"), 'click listener wired to releaseTeamHeldCards');
        assert.ok(js.includes('/kanban/team/release'), 'POSTs to /kanban/team/release');

        // clearTeamBadges still exists for bulk callers
        assert.ok(js.includes('function clearTeamBadges()'), 'clearTeamBadges preserved');
    });

    if (failures > 0) {
        console.error(`\n❌ ${failures} test(s) failed\n`);
        process.exit(1);
    } else {
        console.log('\nAll team-release-control contract tests passed!\n');
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
