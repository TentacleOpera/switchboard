'use strict';

/**
 * Contract: the lead pins a seat per subtask at registration.
 *
 * Round registration carries the lead's seat choice again — a round entry is a
 * bare planId (unpinned) or `{ planId, seat }` (pinned). The dispatcher honours
 * the pin and tags every resolved seat with its source, so a guessed seat never
 * reads like a chosen one.
 *
 * Plan: round-registration-drops-the-leads-seat-choice.md
 *
 * Asserts:
 *  - `round/register` accepts bare strings, `{planId, seat}` objects, and a mix
 *    of both in one round, and echoes `{planId, seat}` in `rounds`/`diff.added`;
 *  - an off-roster seat 400s naming the seat; the lead's own name 400s; a
 *    non-string / empty seat 400s; an entry with no planId 400s;
 *  - a ONE-SUBTASK round pinned to seats[2] dispatches to seats[2] — the exact
 *    case positional dispatch could never reach (the regression gate);
 *  - a round that pins nothing dispatches byte-identically to the old
 *    positional behaviour, tagged `positional-fallback`;
 *  - in a partially-pinned round the cursor advances ONLY on the fallback arm,
 *    so unpinned subtasks do not inherit the pinned ones' offsets;
 *  - a pin that has left the seat pool by dispatch time demotes to
 *    `positional-fallback` rather than throwing;
 *  - a record carrying only `subtaskPlanIds` (a test fake or a thin reader)
 *    dispatches every subtask positionally, never zero;
 *  - `_parseSubtaskSeatEntries` tolerates the `{planId, seat}` array, the
 *    post-V81 bare-string array, and the pre-V81 planId-keyed object (salvaging
 *    `seat`), and yields `[]` on corrupt JSON;
 *  - the three lead-facing surfaces teach the pin syntax, and the standing
 *    order no longer forbids the choice or claims a rotation that never existed.
 */

const assert = require('assert');
const path = require('path');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { LocalApiServer } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
const { STATIC_FRAGMENT_BODIES } = require(path.join(process.cwd(), 'out', 'services', 'standingOrderFragments.js'));

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

const WS = '/tmp/round-seat-pinning-ws';
const LEAD = 'Coding';
// The observed 2026-09-18 roster. seats[2] === 'Coding-intern' is the seat a
// 1- or 2-subtask round could never reach.
const ROSTER = [LEAD, 'Coding-coder-1', 'Coding-coder-2', 'Coding-intern'];

/**
 * A LocalApiServer wired with an in-memory store that supports the WHOLE
 * register path (insert, re-registration diff, auto-dispatch of round 1) and
 * `round/dispatch`. `performKanbanDispatch` is stubbed so every dispatch
 * records the seat it was handed.
 */
function makeServer(opts = {}) {
    const plans = new Map();
    const rounds = new Map();
    const inserted = [];
    const dispatched = [];

    const fakeDb = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => Array.from(plans.values()),
        getPlanByPlanId: async (planId) => plans.get(planId) || null,
        getSubtasksByFeatureId: async (featureId) => {
            const subs = [];
            for (const p of plans.values()) {
                if (p.featureId === featureId && !p.isFeature) subs.push({ planId: p.planId });
            }
            return subs;
        },
        getCodingRoundsByFeature: async (featureId) => Array.from(rounds.values())
            .filter(r => r.featureId === featureId)
            .sort((a, b) => a.ordinal - b.ordinal),
        getCodingRoundsByTeam: async (teamId) => Array.from(rounds.values())
            .filter(r => r.teamId === teamId).sort((a, b) => a.ordinal - b.ordinal),
        getCodingRound: async (roundId) => rounds.get(roundId) || null,
        deleteCodingRoundsByFeatureInStates: async (featureId, states) => {
            for (const [id, r] of Array.from(rounds.entries())) {
                if (r.featureId === featureId && states.includes(r.state)) rounds.delete(id);
            }
            return true;
        },
        insertCodingRound: async (params) => {
            inserted.push(params);
            // Round-trip through the REAL parser: the store persists
            // `subtask_seats` as JSON and every reader parses it back. A test
            // that hands the dispatcher the in-memory object would never catch
            // a shape the parser drops.
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
        ...(opts.db || {}),
    };

    let roster = opts.roster || ROSTER;
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
        resolveTeamMembers: async () => roster,
        resolveTeamPacing: async () => 'head',
        clearTerminalContext: async () => ({ cleared: true }),
        onTeamReleased: async () => {},
        armQueueWatch: async () => {},
    });

    server.performKanbanDispatch = async (_ws, planId, _target, options) => {
        dispatched.push({ planId, seat: options?.targetTerminalOverride });
        return { status: 200, payload: { success: true, planId, dispatched: true } };
    };

    return {
        server, plans, rounds, inserted, dispatched, fakeDb,
        setRoster: (next) => { roster = next; },
    };
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

/** Seed a feature with `n` subtasks named s1..sn. */
function seedFeature(ctx, n) {
    ctx.plans.set('feat-1', { planId: 'feat-1', isFeature: true, featureId: '', workspaceId: 'ws1', kanbanColumn: 'CREATED' });
    for (let i = 1; i <= n; i++) {
        ctx.plans.set(`s${i}`, { planId: `s${i}`, isFeature: false, featureId: 'feat-1', workspaceId: 'ws1', kanbanColumn: 'CODER CODED', ownerSeat: '' });
    }
}

const register = (ctx, rounds) => post(ctx.server, '/kanban/round/register', { from: LEAD, featureId: 'feat-1', rounds, workspaceRoot: WS });

async function run() {
    console.log('\nround seat pinning contract\n');

    // ── 1. The register contract accepts all three entry shapes ───────────────

    await check('register accepts bare strings, {planId, seat} objects, and a mix in one round', async () => {
        const ctx = makeServer();
        seedFeature(ctx, 3);
        const r = await register(ctx, [['s1', { planId: 's2', seat: 'Coding-intern' }], [{ planId: 's3', seat: 'Coding-coder-2' }]]);
        assert.strictEqual(r.status, 200, `register succeeded: ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual(ctx.inserted[0].subtasks, [
            { planId: 's1', seat: null },
            { planId: 's2', seat: 'Coding-intern' },
        ], 'a mixed round normalises to {planId, seat} with null for the unpinned entry');
        assert.deepStrictEqual(ctx.inserted[1].subtasks, [{ planId: 's3', seat: 'Coding-coder-2' }]);
    });

    await check('the register response echoes {planId, seat} in rounds and diff.added', async () => {
        const ctx = makeServer();
        seedFeature(ctx, 2);
        const r = await register(ctx, [[{ planId: 's1', seat: 'Coding-intern' }, 's2']]);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.rounds[0].subtasks, [
            { planId: 's1', seat: 'Coding-intern' },
            { planId: 's2', seat: null },
        ], 'the response confirms the recorded intent, not just the ids');
        assert.deepStrictEqual(r.body.diff.added[0].subtasks, [
            { planId: 's1', seat: 'Coding-intern' },
            { planId: 's2', seat: null },
        ], 'diff.added carries the seats too');
    });

    // ── 2. Identity-only validation ───────────────────────────────────────────

    await check('an off-roster seat 400s and names the seat', async () => {
        const ctx = makeServer();
        seedFeature(ctx, 1);
        const r = await register(ctx, [[{ planId: 's1', seat: 'Coding-ghost' }]]);
        assert.strictEqual(r.status, 400);
        assert.ok(/Coding-ghost/.test(r.body.error), `the error names the seat: ${r.body.error}`);
        assert.strictEqual(ctx.inserted.length, 0, 'nothing was inserted');
        assert.strictEqual(ctx.dispatched.length, 0, 'an unknown seat is never silently swapped for a positional pick');
    });

    await check("pinning a subtask to the lead 400s and names the lead", async () => {
        const ctx = makeServer();
        seedFeature(ctx, 1);
        const r = await register(ctx, [[{ planId: 's1', seat: LEAD }]]);
        assert.strictEqual(r.status, 400);
        assert.ok(r.body.error.includes(LEAD), `the error names the lead: ${r.body.error}`);
    });

    await check('a non-string, empty or whitespace seat 400s; an entry with no planId 400s', async () => {
        for (const bad of [123, '', '   ', {}, []]) {
            const ctx = makeServer();
            seedFeature(ctx, 1);
            const r = await register(ctx, [[{ planId: 's1', seat: bad }]]);
            assert.strictEqual(r.status, 400, `seat ${JSON.stringify(bad)} must 400`);
            assert.ok(/seat/i.test(r.body.error), `the error blames the seat: ${r.body.error}`);
        }
        const ctx = makeServer();
        seedFeature(ctx, 1);
        const missing = await register(ctx, [[{ seat: 'Coding-intern' }]]);
        assert.strictEqual(missing.status, 400);
        assert.ok(/planId/.test(missing.body.error), `the error blames the planId: ${missing.body.error}`);
    });

    await check('an explicit null seat is unpinned, not an error', async () => {
        const ctx = makeServer();
        seedFeature(ctx, 1);
        const r = await register(ctx, [[{ planId: 's1', seat: null }]]);
        assert.strictEqual(r.status, 200, `an explicit null seat registers: ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual(ctx.inserted[0].subtasks, [{ planId: 's1', seat: null }]);
    });

    // ── 3. The regression gate: a 1-subtask round reaches seats[2] ────────────

    await check('a ONE-SUBTASK round pinned to seats[2] dispatches to seats[2]', async () => {
        const ctx = makeServer();
        seedFeature(ctx, 1);
        const r = await register(ctx, [[{ planId: 's1', seat: 'Coding-intern' }]]);
        assert.strictEqual(r.status, 200, `register succeeded: ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual(ctx.dispatched, [{ planId: 's1', seat: 'Coding-intern' }],
            'the third seat receives a one-subtask round — impossible under positional dispatch');
    });

    await check('every round of an all-pinned feature honours its pin, regardless of round size', async () => {
        const ctx = makeServer();
        seedFeature(ctx, 4);
        // The manual-verification shape: four 1-subtask rounds, pinned
        // intern, coder-1, coder-2, intern.
        const pins = ['Coding-intern', 'Coding-coder-1', 'Coding-coder-2', 'Coding-intern'];
        const r = await register(ctx, pins.map((seat, i) => [{ planId: `s${i + 1}`, seat }]));
        assert.strictEqual(r.status, 200, `register succeeded: ${JSON.stringify(r.body)}`);
        // Registration auto-dispatches round 1; dispatch the rest explicitly.
        const ordered = Array.from(ctx.rounds.values()).sort((a, b) => a.ordinal - b.ordinal);
        for (const round of ordered.slice(1)) {
            const d = await post(ctx.server, '/kanban/round/dispatch', { from: LEAD, roundId: round.roundId, workspaceRoot: WS });
            assert.strictEqual(d.status, 200, `round ${round.ordinal} dispatched: ${JSON.stringify(d.body)}`);
            assert.strictEqual(d.body.subtasks[0].source, 'lead-registered', `round ${round.ordinal} honoured the pin`);
        }
        assert.deepStrictEqual(ctx.dispatched.map(d => d.seat), pins,
            'every round lands on its pinned seat — the per-call cursor no longer decides');
    });

    // ── 4. A lead that pins nothing gets today's behaviour ────────────────────

    await check('a round that pins nothing dispatches positionally, tagged positional-fallback', async () => {
        const ctx = makeServer();
        seedFeature(ctx, 2);
        const r = await register(ctx, [['s1', 's2']]);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(ctx.dispatched, [
            { planId: 's1', seat: 'Coding-coder-1' },
            { planId: 's2', seat: 'Coding-coder-2' },
        ], 'unpinned entries keep the old positional assignment exactly');
        const d = await post(ctx.server, '/kanban/round/dispatch', {
            from: LEAD, roundId: Array.from(ctx.rounds.keys())[0], workspaceRoot: WS,
        });
        assert.deepStrictEqual(d.body.subtasks.map(s => s.source),
            ['positional-fallback', 'positional-fallback'],
            'a guessed seat is tagged as guessed');
    });

    // ── 5. The cursor advances only on the fallback arm ───────────────────────

    await check('in a partially-pinned round the unpinned entries do not inherit the pinned ones’ offsets', async () => {
        const ctx = makeServer();
        seedFeature(ctx, 3);
        const r = await register(ctx, [['s1', { planId: 's2', seat: 'Coding-intern' }, 's3']]);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(ctx.dispatched, [
            { planId: 's1', seat: 'Coding-coder-1' },
            { planId: 's2', seat: 'Coding-intern' },
            { planId: 's3', seat: 'Coding-coder-2' },
        ], 's3 takes cursor slot 1, not slot 2 — the pin did not consume a positional slot');
    });

    // ── 6. A stale pin demotes, loudly, rather than throwing ──────────────────

    await check('a pin that has left the seat pool by dispatch time demotes to positional-fallback', async () => {
        const ctx = makeServer();
        seedFeature(ctx, 1);
        const r = await register(ctx, [[{ planId: 's1', seat: 'Coding-intern' }]]);
        assert.strictEqual(r.status, 200);
        // The intern leaves the roster between registration and re-dispatch.
        ctx.setRoster([LEAD, 'Coding-coder-1', 'Coding-coder-2']);
        const roundId = Array.from(ctx.rounds.keys())[0];
        const d = await post(ctx.server, '/kanban/round/dispatch', { from: LEAD, roundId, workspaceRoot: WS });
        assert.strictEqual(d.status, 200, `the round still dispatches: ${JSON.stringify(d.body)}`);
        assert.strictEqual(d.body.subtasks[0].source, 'positional-fallback', 'the demotion is visible in the result');
        assert.strictEqual(d.body.subtasks[0].seat, 'Coding-coder-1', 'it falls back to the positional pick');
    });

    await check('a pin that has become the lead demotes too — no special case', async () => {
        const ctx = makeServer();
        seedFeature(ctx, 1);
        const r = await register(ctx, [[{ planId: 's1', seat: 'Coding-coder-1' }]]);
        assert.strictEqual(r.status, 200);
        const roundId = Array.from(ctx.rounds.keys())[0];
        // Dispatch as the pinned seat: `seats` excludes the poster, so the pin
        // is no longer in the pool.
        const d = await post(ctx.server, '/kanban/round/dispatch', { from: 'Coding-coder-1', roundId, workspaceRoot: WS });
        assert.strictEqual(d.status, 200, JSON.stringify(d.body));
        assert.strictEqual(d.body.subtasks[0].source, 'positional-fallback');
        assert.notStrictEqual(d.body.subtasks[0].seat, 'Coding-coder-1', 'the poster is never a dispatched seat');
    });

    // ── 7. A thin record dispatches everything, never nothing ─────────────────

    await check('a record carrying only subtaskPlanIds dispatches every subtask positionally', async () => {
        const ctx = makeServer();
        seedFeature(ctx, 3);
        ctx.rounds.set('thin', {
            roundId: 'thin', featureId: 'feat-1', teamId: 'team_Coding', workspaceId: 'ws1',
            ordinal: 1, totalRegistered: 1, state: 'registered',
            // No subtaskSeats at all — a test fake or a hand-built row.
            subtaskPlanIds: ['s1', 's2', 's3'],
            registeredAt: '2026-09-20T00:00:00Z', dispatchedAt: null, closedAt: null,
        });
        const d = await post(ctx.server, '/kanban/round/dispatch', { from: LEAD, roundId: 'thin', workspaceRoot: WS });
        assert.strictEqual(d.status, 200, JSON.stringify(d.body));
        assert.strictEqual(d.body.subtasks.length, 3, 'a thin record dispatches all three subtasks, not zero');
        assert.deepStrictEqual(ctx.dispatched.map(x => x.seat),
            ['Coding-coder-1', 'Coding-coder-2', 'Coding-intern']);
        assert.ok(d.body.subtasks.every(s => s.source === 'positional-fallback'));
    });

    // ── 7b. A round dispatch never clears the destination seat ────────────────

    await check('a round dispatch issues no clear, so a double-pinned seat keeps both prompts', async () => {
        const ctx = makeServer();
        seedFeature(ctx, 2);
        // Both subtasks pinned to ONE seat. The plan permits this; the concern
        // was that the second send clears the first's prompt. It cannot:
        // _dispatchRoundCore passes no clearBeforePrompt, and both delivery
        // layers (ptyPromptDelivery `=== true`, tmuxPromptDelivery `if (...)`)
        // treat undefined as "do not clear". Pin the option here so a future
        // caller cannot quietly start clearing mid-round.
        const opts = [];
        ctx.server.performKanbanDispatch = async (_ws, planId, _target, options) => {
            opts.push({ planId, seat: options?.targetTerminalOverride, clearBeforePrompt: options?.clearBeforePrompt });
            return { status: 200, payload: { success: true, planId, dispatched: true } };
        };
        const r = await register(ctx, [[
            { planId: 's1', seat: 'Coding-intern' },
            { planId: 's2', seat: 'Coding-intern' },
        ]]);
        assert.strictEqual(r.status, 200, `a double-pin registers: ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual(opts.map(o => o.seat), ['Coding-intern', 'Coding-intern'],
            'both subtasks go to the pinned seat');
        assert.deepStrictEqual(opts.map(o => o.clearBeforePrompt), [undefined, undefined],
            'no clear is requested on either send — an explicit true here would destroy the first prompt');
        assert.deepStrictEqual(r.body.dispatched && r.body.dispatched.dispatched, true,
            'the round dispatches successfully');
    });

    // ── 8. The parser tolerates all three stored shapes ───────────────────────

    await check('_parseSubtaskSeatEntries tolerates the three shapes and yields [] on corrupt JSON', async () => {
        const parse = (json) => KanbanDatabase.prototype._parseSubtaskSeatEntries.call(null, json);
        assert.deepStrictEqual(parse('[{"planId":"a","seat":"S1"},{"planId":"b","seat":null}]'),
            [{ planId: 'a', seat: 'S1' }, { planId: 'b', seat: null }], 'the current array shape');
        assert.deepStrictEqual(parse('[{"planId":"a","seat":7}]'), [{ planId: 'a', seat: null }],
            'a non-string seat normalises to null');
        assert.deepStrictEqual(parse('["a","b"]'), [{ planId: 'a', seat: null }, { planId: 'b', seat: null }],
            'the post-V81 bare-string array records no seat — and none is invented');
        assert.deepStrictEqual(
            parse('{"a":{"seat":"S1","delivered":true,"delivered_at":"x"},"b":{"seat":""}}'),
            [{ planId: 'a', seat: 'S1' }, { planId: 'b', seat: null }],
            'the pre-V81 object salvages seat and drops the outcome fields');
        assert.deepStrictEqual(parse('{"a":{"seat":"  S1  "}}'), [{ planId: 'a', seat: 'S1' }],
            'a salvaged seat is trimmed — padding would never match the roster and would silently demote the pin');
        assert.deepStrictEqual(parse('not json'), [], 'corrupt JSON yields an empty list');
        assert.deepStrictEqual(parse(null), [], 'a null column yields an empty list');
    });

    // ── 9. The lead is told it may choose (Goal Invariant 5) ──────────────────

    await check('all three lead-facing surfaces teach the pin syntax', async () => {
        const codingHead = STATIC_FRAGMENT_BODIES['team.coding-head.work'];
        const headCompletion = STATIC_FRAGMENT_BODIES['team.head.completion'];
        assert.ok(codingHead && headCompletion, 'both static fragment bodies resolve');
        for (const [name, body] of [['coding-head.work', codingHead], ['head.completion', headCompletion]]) {
            assert.ok(body.includes('"seat"'), `${name} names the seat key in its register example`);
        }
        assert.ok(!codingHead.includes('you do not choose which seat gets which subtask'),
            'the standing order no longer forbids the lead the choice');
        assert.ok(!/rotates one subtask per cleared seat/.test(codingHead),
            'the false rotation claim is gone — no rotation ever existed');

        // The feature-dispatch prompt (_buildDrivePrefix) is built on the
        // provider; read its REGISTER YOUR ROUNDS block off the source so the
        // surface a lead actually reads is the one asserted.
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const idx = src.indexOf('REGISTER YOUR ROUNDS');
        assert.ok(idx > 0, 'the REGISTER YOUR ROUNDS block exists');
        const block = src.slice(idx, idx + 1600);
        assert.ok(block.includes('"seat"'), 'the feature-dispatch prompt names the seat key');
        assert.ok(/must be on your roster/.test(block), 'it states the identity rule the route enforces');
    });

    console.log('');
    if (failures > 0) {
        console.log(`${failures} contract(s) failed.`);
        process.exit(1);
    }
    console.log('ALL PASSED');
}

run().catch(err => { console.error(err); process.exit(1); });
