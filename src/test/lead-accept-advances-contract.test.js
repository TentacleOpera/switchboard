'use strict';

/**
 * Contract: the lead accepts a subtask, and the system advances.
 *
 * The lead has ONE verb: "this subtask is accepted" (POST /kanban/task/complete,
 * driven by `switchboard accept --plan`). The system closes the round when the
 * last subtask in it is accepted, dispatches the next round, and completes the
 * feature when the last round closes. `round/complete` and `feature/complete`
 * stop being things a lead is told to post.
 *
 * Plan: the-lead-accepts-a-subtask-and-the-system-advances.md
 *
 * Asserts:
 *  - accepting the last outstanding subtask of a round closes that round and
 *    dispatches the next;
 *  - accepting a non-last subtask closes nothing and dispatches nothing;
 *  - accepting the last subtask of the LAST round completes the feature and
 *    releases the team ONCE (onTeamReleased fired exactly once, not merely
 *    that the team ended released);
 *  - two concurrent accepts of the last two subtasks close the round once and
 *    dispatch the next once (the conditional closeCodingRoundIfOpen is the
 *    idempotence guard);
 *  - a lead whose team has no registered rounds gets today's behaviour exactly;
 *  - re-accepting an already-accepted subtask advances nothing.
 *
 * CLI checks mirror bare-completion-contract.test.js: `accept --plan` with
 * SWITCHBOARD_TERMINAL set resolves the lead; unset fails naming the variable
 * and accepts nothing; `--plan` missing fails with a DIFFERENT message than the
 * identity failure; explicit `--from` overrides the env.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

const WS = '/tmp/lead-accept-advances-ws';

/** A board row shaped the way `getBoard` returns them. */
function card(planId, extra = {}) {
    return {
        planId,
        sessionId: planId,
        topic: planId,
        kanbanColumn: 'CODER CODED',
        featureId: 'feat-1',
        dispatchedAt: null,
        dispatchedTerminal: '',
        queuePosition: null,
        completedAt: null,
        isFeature: false,
        ...extra,
    };
}

/** A CodingRoundRecord shaped the way getCodingRoundsByTeam returns them. */
function round(opts) {
    return {
        roundId: opts.roundId,
        featureId: opts.featureId || 'feat-1',
        teamId: opts.teamId || 'team_Coding',
        workspaceId: 'ws1',
        ordinal: opts.ordinal,
        totalRegistered: opts.subtaskSeats ? Object.keys(opts.subtaskSeats).length : 0,
        state: opts.state || 'registered',
        subtaskSeats: opts.subtaskSeats || {},
        registeredAt: '2026-09-14T00:00:00Z',
        dispatchedAt: opts.dispatchedAt || null,
        closedAt: opts.closedAt || null,
    };
}

/**
 * A LocalApiServer wired with stub seams for the accept-advances tests.
 * The fake DB records completed_at writes, holds in-memory coding_rounds
 * (with a REAL compare-and-swap closeCodingRoundIfOpen), and supports the
 * subtask/round lookups the accept path needs.
 */
function makeServer(opts = {}) {
    const plans = new Map();
    const events = [];
    const dispatched = [];
    let releaseCount = 0;

    // In-memory coding_rounds keyed by roundId. closeCodingRoundIfOpen is a
    // real compare-and-swap on state — the idempotence guard the plan requires.
    const rounds = new Map();
    let roundDispatchCount = 0;

    const fakeDb = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => {
            // Yield so concurrent accepts interleave at the allComplete check.
            await Promise.resolve();
            return Array.from(plans.values());
        },
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
            p.updatedAt = timestamp;
            return true;
        },
        appendPlanEventByPlanId: async (planId, event) => {
            events.push({ planId, ...event });
            return true;
        },
        getCodingRoundsByTeam: async (teamId) => {
            await Promise.resolve();
            return Array.from(rounds.values()).filter(r => r.teamId === teamId)
                .sort((a, b) => a.ordinal - b.ordinal);
        },
        closeCodingRoundIfOpen: async (roundId, closedAt) => {
            // REAL compare-and-swap: only closes when state is in-flight.
            const r = rounds.get(roundId);
            if (!r) return false;
            if (r.state !== 'dispatched' && r.state !== 'partial') return false;
            r.state = 'closed';
            r.closedAt = closedAt;
            return true;
        },
        closeCodingRound: async (roundId, closedAt) => {
            const r = rounds.get(roundId);
            if (!r) return false;
            r.state = 'closed';
            r.closedAt = closedAt;
            return true;
        },
        updateCodingRoundAfterDispatch: async (roundId, subtaskSeatsJson, state, dispatchedAt) => {
            const r = rounds.get(roundId);
            if (!r) return false;
            r.subtaskSeats = JSON.parse(subtaskSeatsJson);
            r.state = state;
            if (dispatchedAt) r.dispatchedAt = dispatchedAt;
            roundDispatchCount++;
            return true;
        },
        ...(opts.db || {}),
    };

    const clears = [];

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
        clearTerminalContext: opts.clearTerminalContext || (async (_ws, term) => {
            clears.push(term);
            return { cleared: true };
        }),
        onTeamReleased: opts.onTeamReleased || (async () => { releaseCount++; }),
        armQueueWatch: async () => {},
    });

    server.performKanbanDispatch = async (_workspaceRoot, planId, _target, options) => {
        dispatched.push({ planId, seat: options?.targetTerminalOverride });
        return { status: 200, payload: { success: true, planId, dispatched: true } };
    };

    return { server, plans, events, dispatched, clears, rounds, fakeDb, getReleaseCount: () => releaseCount, getRoundDispatchCount: () => roundDispatchCount };
}

/** Make an HTTP request to the server's task/complete endpoint. */
async function postAccept(server, body, authToken) {
    const headers = { 'content-type': 'application/json', 'x-switchboard-client': 'contract-test' };
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
        getHeader: () => undefined,
        getHeaders: () => ({}),
        removeHeader: () => {},
        end: (data) => { responseBody = data ? JSON.parse(data) : null; },
    };
    await server._handleRequest(req, res);
    return { status, body: responseBody };
}

/** Seed a two-round feature: round 1 has subA+subB, round 2 has subC. */
function seedTwoRoundFeature(ctx) {
    const { plans, rounds } = ctx;
    plans.set('feat-1', card('feat-1', { isFeature: true, featureId: 'feat-1', kanbanColumn: 'CREATED' }));
    plans.set('subA', card('subA', { dispatchedTerminal: 'Coder-1' }));
    plans.set('subB', card('subB', { dispatchedTerminal: 'Coder-2' }));
    plans.set('subC', card('subC', { dispatchedTerminal: '' }));
    rounds.set('r1', round({
        roundId: 'r1', ordinal: 1, state: 'dispatched',
        subtaskSeats: { subA: { seat: 'Coder-1', delivered: true, delivered_at: '2026-09-14T00:00:01Z' }, subB: { seat: 'Coder-2', delivered: true, delivered_at: '2026-09-14T00:00:02Z' } },
        dispatchedAt: '2026-09-14T00:00:01Z',
    }));
    rounds.set('r2', round({
        roundId: 'r2', ordinal: 2, state: 'registered',
        subtaskSeats: { subC: { seat: '', delivered: false, delivered_at: null } },
    }));
}

async function run() {
    console.log('\nlead-accept-advances contract\n');

    // ── 1. Last outstanding subtask of a round closes it and dispatches the next ──

    await check('accepting the last outstanding subtask of a round closes it and dispatches the next', async () => {
        const ctx = makeServer();
        seedTwoRoundFeature(ctx);
        // subA already complete (accepted earlier), accept subB (the last in round 1).
        ctx.plans.get('subA').completedAt = '2026-09-14T00:10:00Z';

        const r = await postAccept(ctx.server, { from: 'Coding', planId: 'subB', workspaceRoot: WS }, 'test-token');
        assert.strictEqual(r.status, 200, 'accept succeeds');
        assert.strictEqual(r.body.success, true);
        assert.strictEqual(r.body.roundClosed, 1, 'round 1 was closed by this accept');
        assert.ok(r.body.nextRound, 'a next round was dispatched');
        assert.strictEqual(r.body.nextRound.ordinal, 2, 'round 2 is the next round');
        assert.strictEqual(ctx.rounds.get('r1').state, 'closed', 'round 1 row is closed');
        assert.strictEqual(ctx.rounds.get('r2').state, 'dispatched', 'round 2 was dispatched');
        assert.strictEqual(ctx.getReleaseCount(), 0, 'team NOT released — next round is in flight');
    });

    // ── 2. Non-last subtask closes nothing and dispatches nothing ──────────────

    await check('accepting a non-last subtask closes nothing and dispatches nothing', async () => {
        const ctx = makeServer();
        seedTwoRoundFeature(ctx);

        const r = await postAccept(ctx.server, { from: 'Coding', planId: 'subA', workspaceRoot: WS }, 'test-token');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.success, true);
        assert.strictEqual(r.body.roundClosed, undefined, 'round NOT closed — subB is still outstanding');
        assert.strictEqual(r.body.nextRound, undefined, 'nothing dispatched');
        assert.strictEqual(ctx.rounds.get('r1').state, 'dispatched', 'round 1 still in flight');
        assert.strictEqual(ctx.rounds.get('r2').state, 'registered', 'round 2 still registered');
    });

    // ── 3. Last subtask of the LAST round completes the feature, releases once ──

    await check('accepting the last subtask of the last round completes the feature and releases the team ONCE', async () => {
        const ctx = makeServer();
        seedTwoRoundFeature(ctx);
        // Round 1 already closed; round 2 dispatched with subC.
        ctx.rounds.get('r1').state = 'closed';
        ctx.rounds.get('r1').closedAt = '2026-09-14T00:20:00Z';
        ctx.rounds.get('r2').state = 'dispatched';
        ctx.rounds.get('r2').dispatchedAt = '2026-09-14T00:20:01Z';
        ctx.rounds.get('r2').subtaskSeats.subC = { seat: 'Coder-1', delivered: true, delivered_at: '2026-09-14T00:20:02Z' };
        ctx.plans.get('subA').completedAt = '2026-09-14T00:10:00Z';
        ctx.plans.get('subB').completedAt = '2026-09-14T00:15:00Z';

        const r = await postAccept(ctx.server, { from: 'Coding', planId: 'subC', workspaceRoot: WS }, 'test-token');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.success, true);
        assert.strictEqual(r.body.roundClosed, 2, 'round 2 was closed');
        assert.strictEqual(r.body.featureComplete, true, 'feature is complete');
        assert.strictEqual(ctx.rounds.get('r2').state, 'closed', 'round 2 row is closed');
        assert.strictEqual(ctx.getReleaseCount(), 1, 'onTeamReleased fired EXACTLY once — not twice');
    });

    // ── 4. Two concurrent accepts close the round once and dispatch once ───────

    await check('two concurrent accepts of the last two subtasks close the round once and dispatch the next once', async () => {
        const ctx = makeServer();
        seedTwoRoundFeature(ctx);
        // Both subA and subB are outstanding; accepting both concurrently.
        const [rA, rB] = await Promise.all([
            postAccept(ctx.server, { from: 'Coding', planId: 'subA', workspaceRoot: WS }, 'test-token'),
            postAccept(ctx.server, { from: 'Coding', planId: 'subB', workspaceRoot: WS }, 'test-token'),
        ]);
        assert.strictEqual(rA.body.success, true);
        assert.strictEqual(rB.body.success, true);
        // Exactly one closed the round (the conditional close is the guard).
        const closedCount = [rA, rB].filter(r => r.body.roundClosed === 1).length;
        assert.strictEqual(closedCount, 1, 'exactly one accept closed round 1');
        // The round row is closed exactly once.
        assert.strictEqual(ctx.rounds.get('r1').state, 'closed', 'round 1 is closed');
        // The next round was dispatched exactly once.
        const nextCount = [rA, rB].filter(r => r.body.nextRound && r.body.nextRound.ordinal === 2).length;
        assert.strictEqual(nextCount, 1, 'exactly one accept dispatched round 2');
        assert.strictEqual(ctx.rounds.get('r2').state, 'dispatched', 'round 2 was dispatched');
        assert.strictEqual(ctx.getReleaseCount(), 0, 'team NOT released — next round in flight');
    });

    // ── 5. A lead whose team has no registered rounds gets today's behaviour ───

    await check('a lead whose team has no registered rounds gets today\u2019s behaviour exactly', async () => {
        const ctx = makeServer();
        // No rounds registered.
        ctx.plans.set('plan-x', card('plan-x', { dispatchedTerminal: 'Coder-1' }));

        const r = await postAccept(ctx.server, { from: 'Coding', planId: 'plan-x', workspaceRoot: WS }, 'test-token');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.success, true);
        assert.strictEqual(r.body.roundClosed, undefined, 'no round closed — team has no rounds');
        assert.strictEqual(r.body.nextRound, undefined, 'nothing dispatched');
        assert.strictEqual(r.body.featureComplete, undefined, 'no feature completion');
        // The card is completed; the existing fire-and-forget release path runs.
        assert.ok(ctx.plans.get('plan-x').completedAt, 'card was completed');
    });

    // ── 6. Re-accepting an already-accepted subtask advances nothing ───────────

    await check('re-accepting an already-accepted subtask advances nothing', async () => {
        const ctx = makeServer();
        seedTwoRoundFeature(ctx);
        // subA already complete, subB already complete, round 1 already closed, round 2 dispatched.
        ctx.plans.get('subA').completedAt = '2026-09-14T00:10:00Z';
        ctx.plans.get('subB').completedAt = '2026-09-14T00:15:00Z';
        ctx.rounds.get('r1').state = 'closed';
        ctx.rounds.get('r1').closedAt = '2026-09-14T00:15:01Z';
        ctx.rounds.get('r2').state = 'dispatched';

        const r = await postAccept(ctx.server, { from: 'Coding', planId: 'subA', workspaceRoot: WS }, 'test-token');
        assert.strictEqual(r.status, 200);
        // subA belongs to round 1 which is now 'closed' (not in-flight), so the
        // accept path finds no in-flight round containing it → advances nothing.
        assert.strictEqual(r.body.roundClosed, undefined, 'nothing closed on re-accept');
        assert.strictEqual(r.body.nextRound, undefined, 'nothing dispatched on re-accept');
    });

    // ── 7. CLI: accept --plan resolves the lead from SWITCHBOARD_TERMINAL ──────

    console.log('\n── CLI identity resolution ──\n');

    const CLI = path.join(process.cwd(), 'out', 'standalone', 'cli.js');
    const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-accept-cli-'));

    function runCli(args, env) {
        const childEnv = { ...process.env };
        delete childEnv.SWITCHBOARD_TERMINAL;
        Object.assign(childEnv, env || {});
        const r = spawnSync(process.execPath, [CLI, ...args], {
            cwd: SCRATCH,
            env: childEnv,
            encoding: 'utf8',
            timeout: 30000,
        });
        return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
    }

    await check('the built CLI exists (guards the CLI checks below)', async () => {
        assert.ok(fs.existsSync(CLI), `${CLI} missing — run npm run compile-tests`);
    });

    await check('accept --plan with SWITCHBOARD_TERMINAL set resolves the lead past the identity gate', async () => {
        const { code, out } = runCli(['accept', '--plan', 'subA', '--json'], { SWITCHBOARD_TERMINAL: 'Coding' });
        const body = JSON.parse(out);
        assert.ok(!/SWITCHBOARD_TERMINAL is not set/.test(body.error || ''),
            'accept inside a seat must not ask for --from');
        assert.match(String(body.error || ''), /No running Switchboard instance/,
            'the only remaining failure is the absent board, not a missing field');
        assert.strictEqual(body.from, 'Coding', 'from resolved from the env');
        assert.strictEqual(body.fromSource, 'env');
        assert.notStrictEqual(code, 0);
    });

    await check('SWITCHBOARD_TERMINAL unset accepts nothing and names the variable', async () => {
        const { code, out } = runCli(['accept', '--plan', 'subA', '--json'], {});
        const body = JSON.parse(out);
        assert.strictEqual(body.success, false);
        assert.match(String(body.error || ''), /SWITCHBOARD_TERMINAL/,
            'the error must NAME the variable');
        assert.match(String(body.error || ''), /--from/, 'and it must name the manual override');
        assert.notStrictEqual(code, 0, 'an accept that resolved no lead must never exit zero');
    });

    await check('--plan missing fails with a DIFFERENT message than the identity failure', async () => {
        // With SWITCHBOARD_TERMINAL set, the identity gate passes; the missing
        // --plan is the distinct named error. The two errors must be
        // distinguishable so a lead can tell "you did not say which subtask"
        // from "you are not in a seat".
        const { code, out } = runCli(['accept', '--json'], { SWITCHBOARD_TERMINAL: 'Coding' });
        const body = JSON.parse(out);
        assert.strictEqual(body.success, false);
        assert.match(String(body.error || ''), /--plan/,
            'the missing-plan error must name --plan');
        assert.ok(!/SWITCHBOARD_TERMINAL/.test(body.error || ''),
            'the missing-plan error must NOT be the identity error');
        assert.notStrictEqual(code, 0);
    });

    await check('an explicit --from OVERRIDES the env default', async () => {
        const { out } = runCli(['accept', '--plan', 'subA', '--from', 'Other-Lead', '--json'],
            { SWITCHBOARD_TERMINAL: 'Coding' });
        const body = JSON.parse(out);
        assert.strictEqual(body.from, 'Other-Lead', 'the flag wins over the env');
        assert.strictEqual(body.fromSource, 'flag');
    });

    // ── Summary ──────────────────────────────────────────────────────────────

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
